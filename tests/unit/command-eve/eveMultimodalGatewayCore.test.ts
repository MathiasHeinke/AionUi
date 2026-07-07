/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_GROK_SMART_PLUS_PROFILE,
  EVE_MULTIMODAL_FUNCTION_URL,
  getCommandEveMultimodalContract,
  isExternalToolActionAllowed,
  isHiddenUncensorProfileAllowed,
  resolveCommandEveMultimodalGate,
  validateCommandEveGrokSmartPlusProfile,
  XAI_MULTIMODAL_CONTRACTS,
  type CommandEveMultimodalCapability,
} from '@/common/config/eveMultimodalGatewayCore';

describe('Command EVE multimodal gateway contract', () => {
  it('pins xAI capabilities to server-side contracts and chat-renderable artifact kinds', () => {
    expect(XAI_MULTIMODAL_CONTRACTS.vision).toMatchObject({
      provider: 'xai',
      model: 'grok-4.3',
      endpointKind: 'responses',
      artifactKind: 'text',
      requiresServerSideProviderKey: true,
    });
    expect(XAI_MULTIMODAL_CONTRACTS.image_generation).toMatchObject({
      model: 'grok-imagine-image-quality',
      artifactKind: 'image',
    });
    expect(XAI_MULTIMODAL_CONTRACTS.video_generation).toMatchObject({
      model: 'grok-imagine-video',
      artifactKind: 'video',
      execution: 'async_poll',
      minDurationSeconds: 1,
      maxDurationSeconds: 15,
    });
    expect(XAI_MULTIMODAL_CONTRACTS.tts).toMatchObject({
      endpointKind: 'tts_binary',
      artifactKind: 'audio',
      maxTextChars: 15_000,
      defaultVoiceId: 'eve',
    });
    expect(XAI_MULTIMODAL_CONTRACTS.stt).toMatchObject({
      endpointKind: 'stt_binary',
      artifactKind: 'text',
      maxInputBytes: 20 * 1024 * 1024,
    });
  });

  it('marks realtime voice as ephemeral-token only for client use', () => {
    const contract = getCommandEveMultimodalContract('xai', 'realtime_voice');

    expect(contract).toMatchObject({
      endpointKind: 'realtime_ephemeral',
      artifactKind: 'audio',
      requiresServerSideProviderKey: true,
      requiresEphemeralClientToken: true,
      execution: 'websocket',
    });
  });

  it('blocks raw xAI/provider keys in the desktop app even when every other gate is green', () => {
    const result = resolveCommandEveMultimodalGate({
      provider: 'xai',
      capability: 'tts',
      privacyLane: 'cloud_us',
      hasServerGateway: true,
      hasLicense: true,
      directProviderKeyPresentInDesktop: true,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'direct-provider-key-in-desktop',
    });
  });

  it('blocks when the no-desktop-provider-key attestation is missing', () => {
    const result = resolveCommandEveMultimodalGate({
      provider: 'xai',
      capability: 'tts',
      privacyLane: 'cloud_us',
      hasServerGateway: true,
      hasLicense: true,
    } as Parameters<typeof resolveCommandEveMultimodalGate>[0]);

    expect(result).toMatchObject({
      ok: false,
      reason: 'direct-provider-key-in-desktop',
    });
  });

  it('prioritizes the desktop provider-key tripwire over privacy blocks', () => {
    const result = resolveCommandEveMultimodalGate({
      provider: 'xai',
      capability: 'tts',
      privacyLane: 'local_only',
      hasServerGateway: true,
      hasLicense: true,
      directProviderKeyPresentInDesktop: true,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'direct-provider-key-in-desktop',
    });
  });

  it('fails closed for unsupported providers at runtime', () => {
    const result = resolveCommandEveMultimodalGate({
      provider: 'openrouter',
      capability: 'tts',
      privacyLane: 'cloud_us',
      hasServerGateway: true,
      hasLicense: true,
      directProviderKeyPresentInDesktop: false,
    } as Parameters<typeof resolveCommandEveMultimodalGate>[0]);

    expect(result).toMatchObject({
      ok: false,
      reason: 'provider-unsupported',
    });
  });

  it.each([
    ['local_only', 'local-only-privacy'],
    ['cloud_eu', 'residency-unavailable'],
    ['cloud_de', 'residency-unavailable'],
  ] as const)('fails closed for privacy lane %s', (privacyLane, reason) => {
    const result = resolveCommandEveMultimodalGate({
      provider: 'xai',
      capability: 'video_generation',
      privacyLane,
      hasServerGateway: true,
      hasLicense: true,
      directProviderKeyPresentInDesktop: false,
    });

    expect(result).toMatchObject({ ok: false, reason });
  });

  it.each(['vision', 'image_generation', 'video_generation', 'tts', 'stt', 'realtime_voice'] as const)(
    'allows %s only through the server gateway with a CEVE license',
    (capability: CommandEveMultimodalCapability) => {
      const result = resolveCommandEveMultimodalGate({
        provider: 'xai',
        capability,
        privacyLane: 'cloud_us',
        hasServerGateway: true,
        hasLicense: true,
        directProviderKeyPresentInDesktop: false,
      });

      expect(result).toMatchObject({
        ok: true,
        functionUrl: EVE_MULTIMODAL_FUNCTION_URL,
        residencyConfirmation: 'explicit-us-cloud',
        contract: { capability, provider: 'xai', residencyLane: 'us_cloud' },
      });
    }
  );

  it('does not treat cloud_auto as implicit US without a server-side residency confirmation', () => {
    const result = resolveCommandEveMultimodalGate({
      provider: 'xai',
      capability: 'tts',
      privacyLane: 'cloud_auto',
      hasServerGateway: true,
      hasLicense: true,
      directProviderKeyPresentInDesktop: false,
    });

    expect(result).toMatchObject({
      ok: true,
      residencyConfirmation: 'server-must-confirm-us-cloud',
      contract: { residencyLane: 'us_cloud' },
    });
  });

  it('blocks when the server gateway has not been deployed', () => {
    const result = resolveCommandEveMultimodalGate({
      provider: 'xai',
      capability: 'image_generation',
      privacyLane: 'cloud_auto',
      hasServerGateway: false,
      hasLicense: true,
      directProviderKeyPresentInDesktop: false,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'missing-server-gateway',
    });
  });

  it('blocks when the CEVE license bearer is missing', () => {
    const result = resolveCommandEveMultimodalGate({
      provider: 'xai',
      capability: 'image_generation',
      privacyLane: 'cloud_auto',
      hasServerGateway: true,
      hasLicense: false,
      directProviderKeyPresentInDesktop: false,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'missing-license',
    });
  });

  it('keeps Smart Plus visible and never allows a hidden uncensor prompt profile', () => {
    expect(COMMAND_EVE_GROK_SMART_PLUS_PROFILE).toMatchObject({
      visibleLabel: 'Smart Plus',
      safetyProfile: 'low_refusal_discussion',
      hiddenUncensorPromptAllowed: false,
      externalToolActionsAllowed: false,
      requiresVisibleSafetyReceipt: true,
    });
    expect(isHiddenUncensorProfileAllowed(COMMAND_EVE_GROK_SMART_PLUS_PROFILE)).toBe(false);
    expect(isExternalToolActionAllowed(COMMAND_EVE_GROK_SMART_PLUS_PROFILE)).toBe(false);
    expect(validateCommandEveGrokSmartPlusProfile(COMMAND_EVE_GROK_SMART_PLUS_PROFILE)).toEqual({ ok: true });
    expect(validateCommandEveGrokSmartPlusProfile({ hiddenUncensorPromptAllowed: true })).toEqual({
      ok: false,
      reason: 'hidden-uncensor-prompt',
    });
    expect(validateCommandEveGrokSmartPlusProfile({ externalToolActionsAllowed: true })).toEqual({
      ok: false,
      reason: 'external-tool-actions',
    });
  });
});
