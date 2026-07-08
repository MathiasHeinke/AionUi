/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import path from 'node:path';

export const EVE_MULTIMODAL_FUNCTION_URL = 'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/eve-multimodal';

export const COMMAND_EVE_TTS_SMOKE_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const COMMAND_EVE_TTS_SMOKE_MAX_RESPONSE_BYTES =
  Math.ceil((COMMAND_EVE_TTS_SMOKE_MAX_AUDIO_BYTES * 4) / 3) + 128 * 1024;

export const KEYCHAIN_REF_PREFIX = 'keychain:v1:';
const LICENSE_WIRE_RELATIVE_PATH = path.join('command-eve-runtime', 'entitlement', 'license-wire.json');
const TTS_CONSENT_FILE = 'command-eve-multimodal-tts-consent.json';

const CEVE_WIRE_PREFIX = 'CEVE';
const CEVE_KNOWN_WIRE_VERSIONS = ['v1', 'v2'];
const PRIVACY_LANES = ['local_only', 'cloud_auto', 'cloud_us', 'cloud_eu', 'cloud_de'];
const US_CLOUD_PRIVACY_LANES = ['cloud_auto', 'cloud_us'];
const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/aac',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dedupe(values) {
  return Array.from(
    new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => path.resolve(value)))
  );
}

function commandEveAppSupportPath(homeDir, appName) {
  return path.join(homeDir, 'Library', 'Application Support', appName, 'command-eve');
}

export function commandEveTtsSmokeLicenseWirePath(userDataPath) {
  return path.join(userDataPath, LICENSE_WIRE_RELATIVE_PATH);
}

export function commandEveTtsSmokeConsentPath(userDataPath) {
  return path.join(userDataPath, TTS_CONSENT_FILE);
}

export function resolveCommandEveTtsSmokeUserDataCandidates({
  env = {},
  homeDir,
  platform = process.platform,
  appUserDataPath,
}) {
  const explicit = env.COMMAND_EVE_USER_DATA_PATH || env.COMMAND_EVE_DATA_PATH;
  if (explicit) return [path.resolve(explicit)];

  const candidates = [path.join(homeDir, '.command-eve'), path.join(homeDir, '.command-eve-dev')];
  if (platform === 'darwin') {
    candidates.push(commandEveAppSupportPath(homeDir, 'Command EVE'));
    candidates.push(commandEveAppSupportPath(homeDir, 'Command EVE-dev'));
  }
  if (appUserDataPath) {
    candidates.push(path.join(appUserDataPath, 'command-eve'));
    candidates.push(appUserDataPath);
  }
  return dedupe(candidates);
}

export function resolveCommandEveTtsSmokeUserDataPath({
  env = {},
  homeDir,
  platform = process.platform,
  appUserDataPath,
  existsSync = () => false,
}) {
  const candidates = resolveCommandEveTtsSmokeUserDataCandidates({ env, homeDir, platform, appUserDataPath });
  return candidates.find((candidate) => existsSync(commandEveTtsSmokeLicenseWirePath(candidate))) || candidates[0];
}

export function isWellFormedCeveWire(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith(`${CEVE_WIRE_PREFIX}.`)) return false;
  const parts = trimmed.split('.');
  if (parts.length !== 4) return false;
  const [prefix, wireVersion, payloadB64, sigB64] = parts;
  return (
    prefix === CEVE_WIRE_PREFIX &&
    CEVE_KNOWN_WIRE_VERSIONS.includes(wireVersion) &&
    payloadB64.length > 0 &&
    sigB64.length > 0
  );
}

export function parseCommandEveTtsSmokeLicenseWireRecord(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 'command-eve-license-wire/v0' || typeof parsed.wire_ref !== 'string') {
      return { ok: false, reason_code: 'LICENSE_WIRE_RECORD_INVALID' };
    }
    if (!parsed.wire_ref.startsWith(KEYCHAIN_REF_PREFIX)) {
      return { ok: false, reason_code: 'LICENSE_WIRE_NOT_A_REF' };
    }
    return { ok: true, wire_ref: parsed.wire_ref };
  } catch {
    return { ok: false, reason_code: 'LICENSE_WIRE_RECORD_INVALID_JSON' };
  }
}

function isPrivacyLane(value) {
  return typeof value === 'string' && PRIVACY_LANES.includes(value);
}

export function parseCommandEveTtsSmokeConsent(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { consent: false, privacyLane: 'cloud_auto' };
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return { consent: false, privacyLane: 'cloud_auto' };
    return {
      consent: parsed.consent === true,
      privacyLane: isPrivacyLane(parsed.privacyLane) ? parsed.privacyLane : 'cloud_auto',
    };
  } catch {
    return { consent: false, privacyLane: 'cloud_auto' };
  }
}

function cleanShortToken(value, fallback, maxChars = 64) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.trim().replace(/\s+/g, '-');
  if (!cleaned) return fallback;
  const sliced = cleaned.slice(0, maxChars);
  return /^[A-Za-z0-9._-]+$/.test(sliced) ? sliced : fallback;
}

function prepareText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

export function buildCommandEveTtsSmokeRequest({
  text,
  privacyLane = 'cloud_auto',
  voiceId = 'eve',
  language = 'de-DE',
  requestId,
}) {
  const prepared = prepareText(text);
  if (!prepared) return { ok: false, reason_code: 'EVE_MULTIMODAL_TTS_NO_TEXT' };
  if (prepared.length > 15_000) return { ok: false, reason_code: 'EVE_MULTIMODAL_TTS_TEXT_TOO_LONG' };
  if (!isPrivacyLane(privacyLane)) return { ok: false, reason_code: 'EVE_MULTIMODAL_TTS_INVALID_PRIVACY_LANE' };
  if (privacyLane === 'local_only') return { ok: false, reason_code: 'EVE_MULTIMODAL_TTS_LOCAL_ONLY_PRIVACY' };
  if (!US_CLOUD_PRIVACY_LANES.includes(privacyLane)) {
    return { ok: false, reason_code: 'EVE_MULTIMODAL_TTS_RESIDENCY_UNAVAILABLE' };
  }

  const cleanRequestId = cleanShortToken(requestId, '', 128);
  return {
    ok: true,
    privacyLane,
    body: {
      provider: 'xai',
      capability: 'tts',
      privacyLane,
      directProviderKeyPresentInDesktop: false,
      text: prepared,
      voice_id: cleanShortToken(voiceId, 'eve'),
      language: cleanShortToken(language, 'de-DE', 32),
      ...(cleanRequestId ? { requestId: cleanRequestId } : {}),
    },
  };
}

function normalizedMimeType(value) {
  return typeof value === 'string' ? value.toLowerCase().split(';', 1)[0]?.trim() || '' : '';
}

function isLikelyBase64(value) {
  return (
    typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function decodedBase64ByteLength(value) {
  if (!isLikelyBase64(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function fail(reasonCode, message) {
  return {
    ok: false,
    reason_code: reasonCode,
    ...(message ? { message: redactServerControlledMessage(message) } : {}),
  };
}

export function redactServerControlledMessage(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-or-v1|sk|xai)-[A-Za-z0-9._-]{6,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9._~+/=-]{32,}\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

function parseJsonObject(raw, fallbackReasonCode) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return isRecord(parsed) ? { ok: true, parsed } : fail(fallbackReasonCode, 'TTS smoke response was not an object.');
  } catch {
    return fail(fallbackReasonCode, 'TTS smoke response was not valid JSON.');
  }
}

function cleanReceipt(value) {
  if (!isRecord(value)) return undefined;
  const voiceId = cleanShortToken(value.voice_id, '');
  const language = cleanShortToken(value.language, '', 32);
  const textLength = Number.isInteger(value.text_length) && value.text_length > 0 ? value.text_length : undefined;
  const codec =
    isRecord(value.output_format) && typeof value.output_format.codec === 'string'
      ? cleanShortToken(value.output_format.codec, 'unknown', 32)
      : undefined;
  return voiceId && language && textLength
    ? {
        voice_id: voiceId,
        language,
        text_length: textLength,
        ...(codec ? { output_format: { codec } } : {}),
      }
    : undefined;
}

export function summarizeCommandEveTtsSmokeResponse(raw, expectedPrivacyLane) {
  const parsedResult = parseJsonObject(raw, 'EVE_MULTIMODAL_TTS_BAD_BODY');
  if (!parsedResult.ok) return parsedResult;

  const parsed = parsedResult.parsed;
  if (parsed.ok !== true) {
    const reason =
      typeof parsed.reason === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(parsed.reason)
        ? parsed.reason
        : typeof parsed.reason_code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(parsed.reason_code)
          ? parsed.reason_code
          : 'EVE_MULTIMODAL_TTS_FAILED';
    return fail(reason, typeof parsed.message === 'string' ? parsed.message : undefined);
  }

  if (parsed.provider !== 'xai' || parsed.capability !== 'tts' || parsed.reason !== 'provider-complete') {
    return fail('EVE_MULTIMODAL_TTS_BAD_BODY', 'TTS smoke response had an unexpected success shape.');
  }
  if (!isRecord(parsed.artifact)) {
    return fail('EVE_MULTIMODAL_TTS_BAD_BODY', 'TTS smoke response did not include an artifact.');
  }

  const mimeType = normalizedMimeType(parsed.artifact.mime_type);
  const dataBase64 = typeof parsed.artifact.data_base64 === 'string' ? parsed.artifact.data_base64 : '';
  const bytes =
    Number.isInteger(parsed.artifact.bytes) && parsed.artifact.bytes > 0 ? parsed.artifact.bytes : undefined;
  const decodedBytes = dataBase64 ? decodedBase64ByteLength(dataBase64) : null;
  if (
    parsed.artifact.status !== 'created' ||
    parsed.artifact.kind !== 'audio' ||
    parsed.artifact.encoding !== 'base64' ||
    !ALLOWED_AUDIO_MIME_TYPES.includes(mimeType) ||
    !bytes ||
    decodedBytes !== bytes ||
    bytes > COMMAND_EVE_TTS_SMOKE_MAX_AUDIO_BYTES
  ) {
    return fail('EVE_MULTIMODAL_TTS_BAD_BODY', 'TTS smoke response returned an invalid audio artifact.');
  }

  if (!isRecord(parsed.residency)) {
    return fail('EVE_MULTIMODAL_TTS_BAD_BODY', 'TTS smoke response did not include a residency receipt.');
  }
  const requestedPrivacyLane = parsed.residency.requestedPrivacyLane;
  const effectiveResidency = parsed.residency.effectiveResidency;
  const confirmation = parsed.residency.confirmation;
  if (
    requestedPrivacyLane !== expectedPrivacyLane ||
    effectiveResidency !== 'us_cloud' ||
    (confirmation !== 'explicit-us-cloud' && confirmation !== 'server-must-confirm-us-cloud') ||
    (expectedPrivacyLane === 'cloud_us' && confirmation !== 'explicit-us-cloud')
  ) {
    return fail('EVE_MULTIMODAL_TTS_BAD_BODY', 'TTS smoke response returned an invalid residency receipt.');
  }

  const audioBytes = Buffer.from(dataBase64, 'base64');
  const audioSha256 = crypto.createHash('sha256').update(audioBytes).digest('hex');
  const tts = cleanReceipt(parsed.tts);
  return {
    ok: true,
    provider: 'xai',
    capability: 'tts',
    mime_type: mimeType,
    bytes,
    audio_sha256: audioSha256,
    residency: {
      requestedPrivacyLane,
      effectiveResidency,
      confirmation,
    },
    ...(tts ? { tts } : {}),
  };
}
