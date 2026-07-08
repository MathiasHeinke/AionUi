/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  buildCommandEveMultimodalTtsRequest,
  COMMAND_EVE_MULTIMODAL_TTS_ACTIVATION_STATUS_VERSION,
  COMMAND_EVE_MULTIMODAL_TTS_BRIDGE_VERSION,
  parseCommandEveMultimodalTtsResponse,
  prepareCommandEveMultimodalTtsText,
  resolveCommandEveMultimodalTtsActivationStatus,
  type CommandEveMultimodalTtsRequest,
} from '@/common/config/eveMultimodalGatewayCore';

const VALID_EDGE_RESPONSE = {
  ok: true,
  gateway: 'eve-multimodal',
  provider: 'xai',
  capability: 'tts',
  reason: 'provider-complete',
  message: 'xAI TTS audio generated.',
  checked_at: '2026-07-07T12:00:00.000Z',
  request_id: 'req_test',
  residency: {
    requestedPrivacyLane: 'cloud_us',
    effectiveResidency: 'us_cloud',
    confirmation: 'explicit-us-cloud',
  },
  artifact: {
    status: 'created',
    kind: 'audio',
    mime_type: 'audio/mpeg',
    encoding: 'base64',
    data_base64: 'AAEC',
    bytes: 3,
  },
  tts: {
    voice_id: 'eve',
    language: 'de',
    text_length: 5,
    output_format: { codec: 'mp3' },
  },
};

describe('Command EVE multimodal TTS desktop client core', () => {
  it('builds the server-gateway request without provider keys or license material', () => {
    const result = buildCommandEveMultimodalTtsRequest({
      text: '  Hallo   Welt  ',
      language: 'de',
      voiceId: 'eve-main',
      privacyLane: 'cloud_us',
      requestId: 'req_123',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected request build to pass');
    expect(result.body).toEqual({
      provider: 'xai',
      capability: 'tts',
      privacyLane: 'cloud_us',
      directProviderKeyPresentInDesktop: false,
      text: 'Hallo Welt',
      voice_id: 'eve-main',
      language: 'de',
      requestId: 'req_123',
    });
    expect(JSON.stringify(result.body).toLowerCase()).not.toContain('api_key');
    expect(JSON.stringify(result.body).toLowerCase()).not.toContain('license');
  });

  it('defaults to cloud_auto and the contract voice when optional fields are absent', () => {
    const result = buildCommandEveMultimodalTtsRequest({ text: 'Hello' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected request build to pass');
    expect(result.privacyLane).toBe('cloud_auto');
    expect(result.body.voice_id).toBe('eve');
    expect(result.body.language).toBe('en');
  });

  it('falls back for unsafe voice, language, and request tokens', () => {
    const result = buildCommandEveMultimodalTtsRequest({
      text: 'Hello',
      voiceId: '../evil',
      language: 'de\n<script>',
      requestId: 'req_ä',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected request build to pass');
    expect(result.body.voice_id).toBe('eve');
    expect(result.body.language).toBe('en');
    expect(result.body.requestId).toBeUndefined();
  });

  it('rejects empty or over-limit text before any network call', () => {
    expect(buildCommandEveMultimodalTtsRequest({ text: '   ' })).toMatchObject({
      version: COMMAND_EVE_MULTIMODAL_TTS_BRIDGE_VERSION,
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_NO_TEXT',
    });
    expect(buildCommandEveMultimodalTtsRequest({ text: 'x'.repeat(15_001) })).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_TEXT_TOO_LONG',
    });
    expect(buildCommandEveMultimodalTtsRequest({ text: ` ${'x'.repeat(100_000)} ` })).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_TEXT_TOO_LONG',
    });
  });

  it('rejects local-only, unavailable residency, and invalid privacy lanes before a cloud body is built', () => {
    expect(buildCommandEveMultimodalTtsRequest({ text: 'Hello', privacyLane: 'local_only' })).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_LOCAL_ONLY_PRIVACY',
    });
    expect(buildCommandEveMultimodalTtsRequest({ text: 'Hello', privacyLane: 'cloud_eu' })).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_RESIDENCY_UNAVAILABLE',
    });
    expect(buildCommandEveMultimodalTtsRequest({ text: 'Hello', privacyLane: 'cloud_de' })).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_RESIDENCY_UNAVAILABLE',
    });
    expect(
      buildCommandEveMultimodalTtsRequest({
        text: 'Hello',
        privacyLane: 'cloud_mars',
      } as CommandEveMultimodalTtsRequest)
    ).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_INVALID_PRIVACY_LANE',
    });
  });

  it('collapses whitespace without truncating valid speech text', () => {
    expect(prepareCommandEveMultimodalTtsText('\nBitte   lies\t das vor. ')).toBe('Bitte lies das vor.');
  });

  it('accepts only the validated audio artifact shape from the Edge Function', () => {
    const parsed = parseCommandEveMultimodalTtsResponse(VALID_EDGE_RESPONSE);

    expect(parsed).toMatchObject({
      version: COMMAND_EVE_MULTIMODAL_TTS_BRIDGE_VERSION,
      ok: true,
      provider: 'xai',
      capability: 'tts',
      reason: 'provider-complete',
      artifact: {
        status: 'created',
        kind: 'audio',
        mime_type: 'audio/mpeg',
        encoding: 'base64',
        data_base64: 'AAEC',
        bytes: 3,
      },
      residency: {
        requestedPrivacyLane: 'cloud_us',
        effectiveResidency: 'us_cloud',
        confirmation: 'explicit-us-cloud',
      },
      tts: {
        voice_id: 'eve',
        language: 'de',
        text_length: 5,
      },
    });
    expect(JSON.stringify(parsed)).not.toContain('Hallo');
  });

  it('normalizes allowed audio mime types before returning the artifact', () => {
    const parsed = parseCommandEveMultimodalTtsResponse({
      ...VALID_EDGE_RESPONSE,
      artifact: { ...VALID_EDGE_RESPONSE.artifact, mime_type: 'Audio/MPEG; codecs=mp3' },
    });

    expect(parsed).toMatchObject({
      ok: true,
      artifact: { mime_type: 'audio/mpeg' },
    });
  });

  it('turns server-side blocks into a quiet fail-closed result', () => {
    const parsed = parseCommandEveMultimodalTtsResponse({
      ok: false,
      gateway: 'eve-multimodal',
      provider: 'xai',
      reason: 'provider-not-enabled',
      message: 'Provider is not enabled yet.',
    });

    expect(parsed).toEqual({
      version: COMMAND_EVE_MULTIMODAL_TTS_BRIDGE_VERSION,
      ok: false,
      reason_code: 'provider-not-enabled',
      message: 'Provider is not enabled yet.',
    });
  });

  it('caps and sanitizes server-controlled failure strings before returning them', () => {
    const parsed = parseCommandEveMultimodalTtsResponse({
      ok: false,
      reason: 'bad reason with spaces',
      reason_code: 'provider-not-enabled',
      message: `line 1\n${'long '.repeat(120)}`,
    });

    expect(parsed).toMatchObject({
      ok: false,
      reason_code: 'provider-not-enabled',
    });
    expect(parsed.ok === false ? parsed.message?.length : 0).toBe(300);
    expect(parsed.ok === false ? parsed.message : '').not.toContain('\n');
  });

  it('redacts token-shaped server-controlled failure messages before returning them', () => {
    const parsed = parseCommandEveMultimodalTtsResponse({
      ok: false,
      reason: 'provider-error',
      message:
        'debug Bearer test-license-wire and xai-secret1234567890 and sk-or-v1-secret1234567890 abcdefghijklmnopqrstuvwxyz123456',
    });

    expect(parsed).toMatchObject({
      ok: false,
      reason_code: 'provider-error',
    });
    const message = parsed.ok === false ? parsed.message || '' : '';
    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain('test-license-wire');
    expect(message).not.toContain('xai-secret1234567890');
    expect(message).not.toContain('sk-or-v1-secret1234567890');
    expect(message).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('rejects key-shaped server-controlled reason codes before returning them', () => {
    expect(
      parseCommandEveMultimodalTtsResponse({
        ok: false,
        reason: 'xai-secret1234567890',
        reason_code: 'provider-error',
        message: 'Provider failed.',
      })
    ).toMatchObject({
      ok: false,
      reason_code: 'provider-error',
    });

    expect(
      parseCommandEveMultimodalTtsResponse({
        ok: false,
        reason: 'a'.repeat(80),
        reason_code: 'provider-error',
        message: 'Provider failed.',
      })
    ).toMatchObject({
      ok: false,
      reason_code: 'provider-error',
    });
  });

  it('rejects success bodies that are not audio artifacts', () => {
    expect(
      parseCommandEveMultimodalTtsResponse({
        ...VALID_EDGE_RESPONSE,
        artifact: { ...VALID_EDGE_RESPONSE.artifact, mime_type: 'application/json' },
      })
    ).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_BAD_BODY',
    });
    expect(
      parseCommandEveMultimodalTtsResponse({
        ...VALID_EDGE_RESPONSE,
        artifact: { ...VALID_EDGE_RESPONSE.artifact, mime_type: 'audio/x-mpegurl' },
      })
    ).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_BAD_BODY',
    });
    expect(
      parseCommandEveMultimodalTtsResponse({
        ...VALID_EDGE_RESPONSE,
        artifact: { ...VALID_EDGE_RESPONSE.artifact, data_base64: 'not base64' },
      })
    ).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_BAD_BODY',
    });
    expect(
      parseCommandEveMultimodalTtsResponse({
        ...VALID_EDGE_RESPONSE,
        artifact: { ...VALID_EDGE_RESPONSE.artifact, data_base64: 'AAE=', bytes: 3 },
      })
    ).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_BAD_BODY',
    });
    expect(
      parseCommandEveMultimodalTtsResponse({
        ...VALID_EDGE_RESPONSE,
        artifact: { ...VALID_EDGE_RESPONSE.artifact, bytes: 3.5 },
      })
    ).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_BAD_BODY',
    });
  });

  it('requires a valid residency receipt on successful cloud audio', () => {
    expect(parseCommandEveMultimodalTtsResponse({ ...VALID_EDGE_RESPONSE, residency: undefined })).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_BAD_BODY',
    });
    expect(
      parseCommandEveMultimodalTtsResponse({
        ...VALID_EDGE_RESPONSE,
        residency: {
          requestedPrivacyLane: 'cloud_us',
          effectiveResidency: 'eu_cloud',
          confirmation: 'explicit-us-cloud',
        },
      })
    ).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_BAD_BODY',
    });
    expect(
      parseCommandEveMultimodalTtsResponse(VALID_EDGE_RESPONSE, 'EVE_MULTIMODAL_TTS_BAD_BODY', 'cloud_eu')
    ).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_BAD_BODY',
    });
    expect(
      parseCommandEveMultimodalTtsResponse(
        {
          ...VALID_EDGE_RESPONSE,
          residency: {
            requestedPrivacyLane: 'cloud_us',
            effectiveResidency: 'us_cloud',
            confirmation: 'server-must-confirm-us-cloud',
          },
        },
        'EVE_MULTIMODAL_TTS_BAD_BODY',
        'cloud_us'
      )
    ).toMatchObject({
      ok: false,
      reason_code: 'EVE_MULTIMODAL_TTS_BAD_BODY',
    });
  });

  it('reports cloud TTS as disabled until the desktop egress gate is enabled', () => {
    const status = resolveCommandEveMultimodalTtsActivationStatus({
      desktopCloudEgressEnabled: false,
      mainOwnedPrivacyConsentEnabled: true,
      hasServerGateway: true,
      hasLicense: true,
    });

    expect(status).toEqual({
      version: COMMAND_EVE_MULTIMODAL_TTS_ACTIVATION_STATUS_VERSION,
      ok: true,
      enabled: false,
      reason_code: 'EVE_MULTIMODAL_TTS_NOT_ENABLED',
      message: 'Command EVE cloud TTS is disabled until the desktop release enables the main-owned egress gate.',
      provider: 'xai',
      capability: 'tts',
      privacyLane: 'cloud_auto',
      residencyLane: 'us_cloud',
      requirements: {
        desktopCloudEgressGate: false,
        mainOwnedPrivacyConsent: true,
        serverGateway: true,
        licenseBearer: true,
        residencyAvailable: true,
      },
    });
  });

  it('keeps privacy and residency blocks visible even when the desktop gate is closed', () => {
    expect(
      resolveCommandEveMultimodalTtsActivationStatus({
        privacyLane: 'local_only',
        desktopCloudEgressEnabled: false,
        mainOwnedPrivacyConsentEnabled: false,
        hasServerGateway: true,
        hasLicense: true,
      })
    ).toMatchObject({
      enabled: false,
      reason_code: 'EVE_MULTIMODAL_TTS_LOCAL_ONLY_PRIVACY',
      privacyLane: 'local_only',
      residencyLane: 'blocked',
      requirements: { residencyAvailable: false },
    });

    expect(
      resolveCommandEveMultimodalTtsActivationStatus({
        privacyLane: 'cloud_eu',
        desktopCloudEgressEnabled: true,
        mainOwnedPrivacyConsentEnabled: true,
        hasServerGateway: true,
        hasLicense: true,
      })
    ).toMatchObject({
      enabled: false,
      reason_code: 'EVE_MULTIMODAL_TTS_RESIDENCY_UNAVAILABLE',
      privacyLane: 'cloud_eu',
      residencyLane: 'blocked',
      requirements: { residencyAvailable: false },
    });

    expect(
      resolveCommandEveMultimodalTtsActivationStatus({
        privacyLane: 'cloud_de',
        desktopCloudEgressEnabled: true,
        mainOwnedPrivacyConsentEnabled: true,
        hasServerGateway: true,
        hasLicense: true,
      })
    ).toMatchObject({
      enabled: false,
      reason_code: 'EVE_MULTIMODAL_TTS_RESIDENCY_UNAVAILABLE',
      privacyLane: 'cloud_de',
      residencyLane: 'blocked',
      requirements: { residencyAvailable: false },
    });
  });

  it('requires privacy consent, server gateway, and license after the desktop egress gate opens', () => {
    expect(
      resolveCommandEveMultimodalTtsActivationStatus({
        desktopCloudEgressEnabled: true,
        mainOwnedPrivacyConsentEnabled: false,
        hasServerGateway: true,
        hasLicense: true,
      })
    ).toMatchObject({
      enabled: false,
      reason_code: 'EVE_MULTIMODAL_TTS_PRIVACY_CONSENT_REQUIRED',
    });

    expect(
      resolveCommandEveMultimodalTtsActivationStatus({
        desktopCloudEgressEnabled: true,
        mainOwnedPrivacyConsentEnabled: true,
        hasServerGateway: false,
        hasLicense: true,
      })
    ).toMatchObject({
      enabled: false,
      reason_code: 'EVE_MULTIMODAL_TTS_MISSING_SERVER_GATEWAY',
    });

    expect(
      resolveCommandEveMultimodalTtsActivationStatus({
        desktopCloudEgressEnabled: true,
        mainOwnedPrivacyConsentEnabled: true,
        hasServerGateway: true,
        hasLicense: false,
      })
    ).toMatchObject({
      enabled: false,
      reason_code: 'EVE_MULTIMODAL_TTS_MISSING_LICENSE',
    });
  });

  it('marks cloud TTS ready only when every main-owned gate is satisfied', () => {
    expect(
      resolveCommandEveMultimodalTtsActivationStatus({
        privacyLane: 'cloud_us',
        desktopCloudEgressEnabled: true,
        mainOwnedPrivacyConsentEnabled: true,
        hasServerGateway: true,
        hasLicense: true,
      })
    ).toMatchObject({
      enabled: true,
      reason_code: 'EVE_MULTIMODAL_TTS_READY',
      privacyLane: 'cloud_us',
      residencyLane: 'us_cloud',
      requirements: {
        desktopCloudEgressGate: true,
        mainOwnedPrivacyConsent: true,
        serverGateway: true,
        licenseBearer: true,
        residencyAvailable: true,
      },
    });
  });

  it('rejects invalid privacy lanes in the activation status path', () => {
    expect(
      resolveCommandEveMultimodalTtsActivationStatus({
        privacyLane: 'cloud_mars',
        desktopCloudEgressEnabled: true,
        mainOwnedPrivacyConsentEnabled: true,
        hasServerGateway: true,
        hasLicense: true,
      })
    ).toMatchObject({
      enabled: false,
      reason_code: 'EVE_MULTIMODAL_TTS_INVALID_PRIVACY_LANE',
      privacyLane: 'cloud_auto',
      residencyLane: 'blocked',
      requirements: { residencyAvailable: false },
    });
  });
});
