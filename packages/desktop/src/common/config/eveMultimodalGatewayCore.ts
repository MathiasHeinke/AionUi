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
