/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE multimodal gateway contract.
 *
 * This is intentionally a pure fail-closed core. It does not call xAI, does not
 * read a provider key, and does not enable a renderer bridge. It pins the product
 * invariant for future Grok/xAI multimodal work:
 *
 * - managed provider keys live server-side, never in the DMG;
 * - client-side realtime voice uses short-lived server-minted tokens only;
 * - local-only / EU / DE privacy modes block the current xAI US lane;
 * - generated media must return an artifact contract the chat renderer can show;
 * - "Smart Plus" is a visible low-refusal discussion profile, not a hidden
 *   uncensor prompt or a tool-action bypass.
 */

export const EVE_MULTIMODAL_FUNCTION_URL = 'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/eve-multimodal';

export type CommandEveMultimodalProvider = 'xai';

export type CommandEveMultimodalCapability =
  | 'vision'
  | 'image_generation'
  | 'video_generation'
  | 'tts'
  | 'stt'
  | 'realtime_voice';

export type CommandEveMultimodalEndpointKind =
  | 'responses'
  | 'image_generation'
  | 'video_generation_async'
  | 'tts_binary'
  | 'stt_binary'
  | 'realtime_ephemeral';

export type CommandEveMultimodalArtifactKind = 'text' | 'image' | 'video' | 'audio';

export type CommandEvePrivacyLane = 'local_only' | 'cloud_auto' | 'cloud_us' | 'cloud_eu' | 'cloud_de';

export type CommandEveMultimodalBlockReason =
  | 'provider-unsupported'
  | 'direct-provider-key-in-desktop'
  | 'missing-server-gateway'
  | 'missing-license'
  | 'local-only-privacy'
  | 'residency-unavailable';

export type CommandEveMultimodalContract = {
  provider: CommandEveMultimodalProvider;
  capability: CommandEveMultimodalCapability;
  model: string;
  endpointKind: CommandEveMultimodalEndpointKind;
  artifactKind: CommandEveMultimodalArtifactKind;
  residencyLane: 'us_cloud';
  requiresServerSideProviderKey: true;
  requiresEphemeralClientToken: boolean;
  execution: 'sync' | 'async_poll' | 'websocket';
  maxInputBytes?: number;
  maxTextChars?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  defaultVoiceId?: string;
};

export type CommandEveMultimodalGateInput = {
  provider: CommandEveMultimodalProvider;
  capability: CommandEveMultimodalCapability;
  privacyLane: CommandEvePrivacyLane;
  hasServerGateway: boolean;
  hasLicense: boolean;
  /** Defensive tripwire: managed Command EVE must not use raw provider keys in the desktop bundle. */
  directProviderKeyPresentInDesktop: boolean;
};

export type CommandEveMultimodalGateResult =
  | {
      ok: true;
      functionUrl: string;
      contract: CommandEveMultimodalContract;
      residencyConfirmation: 'explicit-us-cloud' | 'server-must-confirm-us-cloud';
    }
  | {
      ok: false;
      reason: CommandEveMultimodalBlockReason;
      message: string;
      contract?: CommandEveMultimodalContract;
    };

export const COMMAND_EVE_MULTIMODAL_TTS_BRIDGE_VERSION = 'command-eve-multimodal-tts/v0' as const;

export const COMMAND_EVE_MULTIMODAL_TTS_MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export const COMMAND_EVE_MULTIMODAL_TTS_MAX_RESPONSE_BYTES =
  Math.ceil((COMMAND_EVE_MULTIMODAL_TTS_MAX_AUDIO_BYTES * 4) / 3) + 128 * 1024;

export const COMMAND_EVE_MULTIMODAL_TTS_ALLOWED_MIME_TYPES = [
  'audio/aac',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
] as const;

export type CommandEveMultimodalTtsRequest = {
  text?: string;
  language?: string;
  voiceId?: string;
  privacyLane?: CommandEvePrivacyLane;
  requestId?: string;
};

export type CommandEveMultimodalTtsEdgeRequestBody = {
  provider: 'xai';
  capability: 'tts';
  privacyLane: CommandEvePrivacyLane;
  directProviderKeyPresentInDesktop: false;
  text: string;
  voice_id: string;
  language: string;
  requestId?: string;
};

export type CommandEveMultimodalTtsArtifact = {
  status: 'created';
  kind: 'audio';
  mime_type: string;
  encoding: 'base64';
  data_base64: string;
  bytes: number;
};

export type CommandEveMultimodalTtsResidency = {
  requestedPrivacyLane: CommandEvePrivacyLane;
  effectiveResidency: 'us_cloud';
  confirmation: 'explicit-us-cloud' | 'server-must-confirm-us-cloud';
};

export type CommandEveMultimodalTtsReceipt = {
  voice_id: string;
  language: string;
  text_length: number;
  output_format?: { codec: string };
};

export type CommandEveMultimodalTtsSuccessResult = {
  version: typeof COMMAND_EVE_MULTIMODAL_TTS_BRIDGE_VERSION;
  ok: true;
  provider: 'xai';
  capability: 'tts';
  reason: 'provider-complete';
  artifact: CommandEveMultimodalTtsArtifact;
  residency: CommandEveMultimodalTtsResidency;
  tts?: CommandEveMultimodalTtsReceipt;
};

export type CommandEveMultimodalTtsFailureResult = {
  version: typeof COMMAND_EVE_MULTIMODAL_TTS_BRIDGE_VERSION;
  ok: false;
  reason_code: string;
  message?: string;
};

export type CommandEveMultimodalTtsResult = CommandEveMultimodalTtsSuccessResult | CommandEveMultimodalTtsFailureResult;

export type BuildCommandEveMultimodalTtsRequestResult =
  | {
      ok: true;
      body: CommandEveMultimodalTtsEdgeRequestBody;
      privacyLane: CommandEvePrivacyLane;
    }
  | CommandEveMultimodalTtsFailureResult;

export type CommandEveGrokSmartPlusProfile = {
  id: 'grok-smart-plus-discussion';
  visibleLabel: 'Smart Plus';
  safetyProfile: 'low_refusal_discussion';
  hiddenUncensorPromptAllowed: false;
  externalToolActionsAllowed: false;
  requiresVisibleSafetyReceipt: true;
};

export type CommandEveGrokSmartPlusValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: 'hidden-uncensor-prompt' | 'external-tool-actions' | 'missing-visible-safety-receipt';
    };

export const COMMAND_EVE_GROK_SMART_PLUS_PROFILE: CommandEveGrokSmartPlusProfile = {
  id: 'grok-smart-plus-discussion',
  visibleLabel: 'Smart Plus',
  safetyProfile: 'low_refusal_discussion',
  hiddenUncensorPromptAllowed: false,
  externalToolActionsAllowed: false,
  requiresVisibleSafetyReceipt: true,
};

export const XAI_MULTIMODAL_CONTRACTS: Record<CommandEveMultimodalCapability, CommandEveMultimodalContract> = {
  vision: {
    provider: 'xai',
    capability: 'vision',
    model: 'grok-4.3',
    endpointKind: 'responses',
    artifactKind: 'text',
    residencyLane: 'us_cloud',
    requiresServerSideProviderKey: true,
    requiresEphemeralClientToken: false,
    execution: 'sync',
    maxInputBytes: 20 * 1024 * 1024,
  },
  image_generation: {
    provider: 'xai',
    capability: 'image_generation',
    model: 'grok-imagine-image-quality',
    endpointKind: 'image_generation',
    artifactKind: 'image',
    residencyLane: 'us_cloud',
    requiresServerSideProviderKey: true,
    requiresEphemeralClientToken: false,
    execution: 'sync',
  },
  video_generation: {
    provider: 'xai',
    capability: 'video_generation',
    model: 'grok-imagine-video',
    endpointKind: 'video_generation_async',
    artifactKind: 'video',
    residencyLane: 'us_cloud',
    requiresServerSideProviderKey: true,
    requiresEphemeralClientToken: false,
    execution: 'async_poll',
    minDurationSeconds: 1,
    maxDurationSeconds: 15,
  },
  tts: {
    provider: 'xai',
    capability: 'tts',
    model: 'grok-voice-tts',
    endpointKind: 'tts_binary',
    artifactKind: 'audio',
    residencyLane: 'us_cloud',
    requiresServerSideProviderKey: true,
    requiresEphemeralClientToken: false,
    execution: 'sync',
    maxTextChars: 15_000,
    defaultVoiceId: 'eve',
  },
  stt: {
    provider: 'xai',
    capability: 'stt',
    model: 'grok-voice-stt',
    endpointKind: 'stt_binary',
    artifactKind: 'text',
    residencyLane: 'us_cloud',
    requiresServerSideProviderKey: true,
    requiresEphemeralClientToken: false,
    execution: 'sync',
    maxInputBytes: 20 * 1024 * 1024,
  },
  realtime_voice: {
    provider: 'xai',
    capability: 'realtime_voice',
    model: 'grok-voice-latest',
    endpointKind: 'realtime_ephemeral',
    artifactKind: 'audio',
    residencyLane: 'us_cloud',
    requiresServerSideProviderKey: true,
    requiresEphemeralClientToken: true,
    execution: 'websocket',
  },
};

const MULTIMODAL_PRIVACY_LANES: readonly CommandEvePrivacyLane[] = [
  'local_only',
  'cloud_auto',
  'cloud_us',
  'cloud_eu',
  'cloud_de',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPrivacyLane(value: unknown): value is CommandEvePrivacyLane {
  return typeof value === 'string' && MULTIMODAL_PRIVACY_LANES.includes(value as CommandEvePrivacyLane);
}

function cleanShortToken(value: unknown, fallback: string, maxChars = 64): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.trim().replace(/\s+/g, '-');
  if (!cleaned) return fallback;
  const sliced = cleaned.slice(0, maxChars);
  return /^[A-Za-z0-9._-]+$/.test(sliced) ? sliced : fallback;
}

function failure(reasonCode: string, message?: string): CommandEveMultimodalTtsFailureResult {
  return {
    version: COMMAND_EVE_MULTIMODAL_TTS_BRIDGE_VERSION,
    ok: false,
    reason_code: reasonCode,
    ...(message ? { message } : {}),
  };
}

export function prepareCommandEveMultimodalTtsText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

export function commandEveMultimodalTtsFailure(
  reasonCode: string,
  message?: string
): CommandEveMultimodalTtsFailureResult {
  return failure(reasonCode, message);
}

export function buildCommandEveMultimodalTtsRequest(
  request?: CommandEveMultimodalTtsRequest
): BuildCommandEveMultimodalTtsRequestResult {
  const contract = XAI_MULTIMODAL_CONTRACTS.tts;
  if (
    typeof request?.text === 'string' &&
    contract.maxTextChars &&
    request.text.length > contract.maxTextChars + 1024
  ) {
    return failure(
      'EVE_MULTIMODAL_TTS_TEXT_TOO_LONG',
      `Command EVE TTS text exceeds ${contract.maxTextChars} characters.`
    );
  }

  const text = prepareCommandEveMultimodalTtsText(request?.text);
  if (!text) {
    return failure('EVE_MULTIMODAL_TTS_NO_TEXT', 'Command EVE TTS requires non-empty text.');
  }
  if (contract.maxTextChars && text.length > contract.maxTextChars) {
    return failure(
      'EVE_MULTIMODAL_TTS_TEXT_TOO_LONG',
      `Command EVE TTS text exceeds ${contract.maxTextChars} characters.`
    );
  }

  if (request?.privacyLane !== undefined && !isPrivacyLane(request.privacyLane)) {
    return failure('EVE_MULTIMODAL_TTS_INVALID_PRIVACY_LANE', 'Command EVE TTS received an invalid privacy lane.');
  }
  if (request?.privacyLane === 'local_only') {
    return failure(
      'EVE_MULTIMODAL_TTS_LOCAL_ONLY_PRIVACY',
      'Command EVE cloud TTS is blocked while local-only privacy mode is active.'
    );
  }
  if (request?.privacyLane === 'cloud_eu' || request?.privacyLane === 'cloud_de') {
    return failure(
      'EVE_MULTIMODAL_TTS_RESIDENCY_UNAVAILABLE',
      'Command EVE cloud TTS is currently available only through the US cloud lane.'
    );
  }

  const privacyLane = request?.privacyLane ?? 'cloud_auto';
  const voiceId = cleanShortToken(request?.voiceId, contract.defaultVoiceId || 'eve');
  const language = cleanShortToken(request?.language, 'en', 32);
  const requestId = cleanShortToken(request?.requestId, '', 128);

  return {
    ok: true,
    privacyLane,
    body: {
      provider: 'xai',
      capability: 'tts',
      privacyLane,
      directProviderKeyPresentInDesktop: false,
      text,
      voice_id: voiceId,
      language,
      ...(requestId ? { requestId } : {}),
    },
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function messageField(record: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(record, key);
  return value ? value.replace(/\s+/g, ' ').slice(0, 300) : undefined;
}

function reasonCodeField(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = stringField(record, key);
  if (!value) return fallback;
  const cleaned = value.slice(0, 128);
  return /^[A-Za-z0-9_.-]+$/.test(cleaned) ? cleaned : fallback;
}

function positiveNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveIntegerField(record: Record<string, unknown>, key: string): number | undefined {
  const value = positiveNumberField(record, key);
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function isLikelyBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function decodedBase64ByteLength(value: string): number | null {
  if (!isLikelyBase64(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function normalizedMimeType(value: string): string {
  return value.toLowerCase().split(';', 1)[0]?.trim() || '';
}

function parseResidency(value: unknown): CommandEveMultimodalTtsResidency | undefined {
  if (!isRecord(value)) return undefined;
  const requestedPrivacyLane = stringField(value, 'requestedPrivacyLane');
  const effectiveResidency = stringField(value, 'effectiveResidency');
  const confirmation = stringField(value, 'confirmation');
  if (
    !isPrivacyLane(requestedPrivacyLane) ||
    effectiveResidency !== 'us_cloud' ||
    (confirmation !== 'explicit-us-cloud' && confirmation !== 'server-must-confirm-us-cloud')
  ) {
    return undefined;
  }
  return {
    requestedPrivacyLane,
    effectiveResidency,
    confirmation,
  };
}

function parseTtsReceipt(value: unknown): CommandEveMultimodalTtsReceipt | undefined {
  if (!isRecord(value)) return undefined;
  const voiceId = cleanShortToken(value.voice_id, '');
  const language = cleanShortToken(value.language, '', 32);
  const textLength = positiveIntegerField(value, 'text_length');
  if (!voiceId || !language || !textLength) return undefined;
  const outputFormat =
    isRecord(value.output_format) && typeof value.output_format.codec === 'string'
      ? { codec: cleanShortToken(value.output_format.codec, 'unknown', 32) }
      : undefined;
  return {
    voice_id: voiceId,
    language,
    text_length: textLength,
    ...(outputFormat ? { output_format: outputFormat } : {}),
  };
}

export function parseCommandEveMultimodalTtsResponse(
  raw: unknown,
  fallbackReasonCode = 'EVE_MULTIMODAL_TTS_BAD_BODY',
  expectedPrivacyLane?: CommandEvePrivacyLane
): CommandEveMultimodalTtsResult {
  if (!isRecord(raw)) {
    return failure(fallbackReasonCode, 'Command EVE multimodal returned a non-object response.');
  }

  if (raw.ok !== true) {
    const reason = reasonCodeField(raw, 'reason', reasonCodeField(raw, 'reason_code', fallbackReasonCode));
    return failure(reason, messageField(raw, 'message'));
  }

  if (raw.provider !== 'xai' || raw.capability !== 'tts' || raw.reason !== 'provider-complete') {
    return failure(fallbackReasonCode, 'Command EVE multimodal returned an unexpected TTS success shape.');
  }

  if (!isRecord(raw.artifact)) {
    return failure(fallbackReasonCode, 'Command EVE multimodal did not return an audio artifact.');
  }

  const mimeType = stringField(raw.artifact, 'mime_type');
  const encoding = stringField(raw.artifact, 'encoding');
  const dataBase64 = stringField(raw.artifact, 'data_base64');
  const bytes = positiveIntegerField(raw.artifact, 'bytes');
  const decodedBytes = dataBase64 ? decodedBase64ByteLength(dataBase64) : null;
  const mimeTypeNormalized = mimeType ? normalizedMimeType(mimeType) : '';
  if (
    raw.artifact.status !== 'created' ||
    raw.artifact.kind !== 'audio' ||
    !COMMAND_EVE_MULTIMODAL_TTS_ALLOWED_MIME_TYPES.includes(
      mimeTypeNormalized as (typeof COMMAND_EVE_MULTIMODAL_TTS_ALLOWED_MIME_TYPES)[number]
    ) ||
    encoding !== 'base64' ||
    !dataBase64 ||
    !bytes ||
    decodedBytes !== bytes ||
    bytes > COMMAND_EVE_MULTIMODAL_TTS_MAX_AUDIO_BYTES
  ) {
    return failure(fallbackReasonCode, 'Command EVE multimodal returned an invalid audio artifact.');
  }

  const residency = parseResidency(raw.residency);
  if (
    !residency ||
    (expectedPrivacyLane && residency.requestedPrivacyLane !== expectedPrivacyLane) ||
    (expectedPrivacyLane === 'cloud_us' && residency.confirmation !== 'explicit-us-cloud')
  ) {
    return failure(fallbackReasonCode, 'Command EVE multimodal did not return a valid residency receipt.');
  }

  const tts = parseTtsReceipt(raw.tts);

  return {
    version: COMMAND_EVE_MULTIMODAL_TTS_BRIDGE_VERSION,
    ok: true,
    provider: 'xai',
    capability: 'tts',
    reason: 'provider-complete',
    artifact: {
      status: 'created',
      kind: 'audio',
      mime_type: mimeTypeNormalized,
      encoding: 'base64',
      data_base64: dataBase64,
      bytes,
    },
    residency,
    ...(tts ? { tts } : {}),
  };
}

export function getCommandEveMultimodalContract(
  provider: CommandEveMultimodalProvider,
  capability: CommandEveMultimodalCapability
): CommandEveMultimodalContract | undefined {
  if (provider !== 'xai') return undefined;
  return XAI_MULTIMODAL_CONTRACTS[capability];
}

function residencyBlockedMessage(privacyLane: CommandEvePrivacyLane): string {
  if (privacyLane === 'cloud_eu') {
    return 'xAI multimodal is currently a US cloud lane; EU cloud routing is not available for this provider yet.';
  }
  if (privacyLane === 'cloud_de') {
    return 'xAI multimodal is currently a US cloud lane; German cloud routing is not available for this provider yet.';
  }
  return 'xAI multimodal is not allowed while local-only privacy mode is active.';
}

export function resolveCommandEveMultimodalGate(input: CommandEveMultimodalGateInput): CommandEveMultimodalGateResult {
  const contract = getCommandEveMultimodalContract(input.provider, input.capability);
  if (!contract) {
    return {
      ok: false,
      reason: 'provider-unsupported',
      message: `Unsupported Command EVE multimodal provider/capability: ${input.provider}/${input.capability}`,
    };
  }

  if (input.directProviderKeyPresentInDesktop !== false) {
    return {
      ok: false,
      reason: 'direct-provider-key-in-desktop',
      message: 'Managed Command EVE multimodal lanes must not use raw xAI/provider keys in the desktop app.',
      contract,
    };
  }

  if (input.privacyLane === 'local_only') {
    return {
      ok: false,
      reason: 'local-only-privacy',
      message: residencyBlockedMessage(input.privacyLane),
      contract,
    };
  }

  if (input.privacyLane === 'cloud_eu' || input.privacyLane === 'cloud_de') {
    return {
      ok: false,
      reason: 'residency-unavailable',
      message: residencyBlockedMessage(input.privacyLane),
      contract,
    };
  }

  if (!input.hasServerGateway) {
    return {
      ok: false,
      reason: 'missing-server-gateway',
      message: 'Command EVE multimodal requires the server-side eve-multimodal gateway before xAI can be used.',
      contract,
    };
  }

  if (!input.hasLicense) {
    return {
      ok: false,
      reason: 'missing-license',
      message: 'Command EVE multimodal requires the CEVE license bearer; provider keys are never sent from desktop.',
      contract,
    };
  }

  return {
    ok: true,
    functionUrl: EVE_MULTIMODAL_FUNCTION_URL,
    contract,
    residencyConfirmation: input.privacyLane === 'cloud_auto' ? 'server-must-confirm-us-cloud' : 'explicit-us-cloud',
  };
}

export function isHiddenUncensorProfileAllowed(profile: { hiddenUncensorPromptAllowed?: unknown }): boolean {
  return profile.hiddenUncensorPromptAllowed === true;
}

export function isExternalToolActionAllowed(profile: { externalToolActionsAllowed?: unknown }): boolean {
  return profile.externalToolActionsAllowed === true;
}

export function validateCommandEveGrokSmartPlusProfile(
  profile: Partial<Record<keyof CommandEveGrokSmartPlusProfile, unknown>>
): CommandEveGrokSmartPlusValidationResult {
  if (isHiddenUncensorProfileAllowed(profile)) {
    return { ok: false, reason: 'hidden-uncensor-prompt' };
  }
  if (isExternalToolActionAllowed(profile)) {
    return { ok: false, reason: 'external-tool-actions' };
  }
  if (profile.requiresVisibleSafetyReceipt !== true) {
    return { ok: false, reason: 'missing-visible-safety-receipt' };
  }
  return { ok: true };
}
