/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_GROK_SMART_PLUS_PROFILE,
  commandEveMediaSeedAttribution,
  EVE_MULTIMODAL_FUNCTION_URL,
  getCommandEveMultimodalContract,
  isExternalToolActionAllowed,
  isHiddenUncensorProfileAllowed,
  resolveCommandEveMultimodalGate,
  validateCommandEveGrokSmartPlusProfile,
  XAI_MULTIMODAL_CONTRACTS,
  OPENROUTER_IMAGE_MULTIMODAL_CONTRACT,
  OPENROUTER_PDF_MULTIMODAL_CONTRACT,
  type CommandEveMultimodalCapability,
} from '@/common/config/eveMultimodalGatewayCore';

describe('Command EVE multimodal gateway contract', () => {
  it('emits a canonical active Seed UUID as media attribution', () => {
    expect(commandEveMediaSeedAttribution('A2000000-0000-4000-8000-000000000001')).toEqual({
      seat_id: 'a2000000-0000-4000-8000-000000000001',
    });
  });

  it.each(['seat-1', 'client-safe-slug', ' a2000000-0000-4000-8000-000000000001 ', null])(
    'omits non-server Seed attribution %s',
    (value) => {
      expect(commandEveMediaSeedAttribution(value)).toEqual({});
    }
  );

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

  it('pins OpenRouter PDF OCR to the server-side global ZDR document contract', () => {
    expect(OPENROUTER_PDF_MULTIMODAL_CONTRACT).toMatchObject({
      provider: 'openrouter',
      capability: 'document_ocr',
      model: 'google/gemini-2.5-flash',
      endpointKind: 'document_processing',
      artifactKind: 'document',
      residencyLane: 'global_cloud',
      requiresServerSideProviderKey: true,
      maxInputBytes: 12 * 1024 * 1024,
    });
    expect(getCommandEveMultimodalContract('openrouter', 'document_ocr')).toBe(OPENROUTER_PDF_MULTIMODAL_CONTRACT);
  });

  it('pins managed image generation to the server-side global ZDR image contract', () => {
    expect(OPENROUTER_IMAGE_MULTIMODAL_CONTRACT).toMatchObject({
      provider: 'openrouter',
      capability: 'image_generation',
      model: 'google/gemini-3-pro-image',
      endpointKind: 'image_generation',
      artifactKind: 'image',
      residencyLane: 'global_cloud',
      maxInputBytes: 8 * 1024 * 1024,
      maxTextChars: 12_000,
    });
    expect(getCommandEveMultimodalContract('openrouter', 'image_generation')).toBe(
      OPENROUTER_IMAGE_MULTIMODAL_CONTRACT
    );
    expect(
      resolveCommandEveMultimodalGate({
        provider: 'openrouter',
        capability: 'image_generation',
        privacyLane: 'cloud_auto',
        hasServerGateway: true,
        hasLicense: true,
        directProviderKeyPresentInDesktop: false,
      })
    ).toMatchObject({
      ok: true,
      residencyConfirmation: 'zdr-enforced-global',
      contract: { model: 'google/gemini-3-pro-image' },
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

  it('allows OpenRouter PDF OCR only through explicit global cloud_auto with ZDR', () => {
    const result = resolveCommandEveMultimodalGate({
      provider: 'openrouter',
      capability: 'document_ocr',
      privacyLane: 'cloud_auto',
      hasServerGateway: true,
      hasLicense: true,
      directProviderKeyPresentInDesktop: false,
    });

    expect(result).toMatchObject({
      ok: true,
      functionUrl: EVE_MULTIMODAL_FUNCTION_URL,
      residencyConfirmation: 'zdr-enforced-global',
      contract: {
        provider: 'openrouter',
        capability: 'document_ocr',
        residencyLane: 'global_cloud',
      },
    });
  });

  it.each(['local_only', 'cloud_us', 'cloud_eu', 'cloud_de'] as const)(
    'blocks OpenRouter PDF OCR privacy lane %s without making residency claims',
    (privacyLane) => {
      const result = resolveCommandEveMultimodalGate({
        provider: 'openrouter',
        capability: 'document_ocr',
        privacyLane,
        hasServerGateway: true,
        hasLicense: true,
        directProviderKeyPresentInDesktop: false,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: privacyLane === 'local_only' ? 'local-only-privacy' : 'residency-unavailable',
      });
    }
  );

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
